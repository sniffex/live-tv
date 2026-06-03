document.addEventListener('DOMContentLoaded', () => {
    // --- DOM refs ---
    const loadBtn = document.getElementById('load-btn');
    const m3uUrlInput = document.getElementById('m3u-url');
    const channelListEl = document.getElementById('channel-list');
    const channelCountEl = document.getElementById('channel-count');
    const searchInput = document.getElementById('search-channels');
    const video = document.getElementById('video-player');
    const loadingOverlay = document.getElementById('loading-overlay');
    const currentChannelInfo = document.getElementById('current-channel-info');
    const currentChannelLogo = document.getElementById('current-channel-logo');
    const currentChannelName = document.getElementById('current-channel-name');
    const currentChannelGroup = document.getElementById('current-channel-group');
    const settingsBtn = document.getElementById('settings-btn');
    const settingsPanel = document.getElementById('settings-panel');
    const bufferSlider = document.getElementById('buffer-slider');
    const bufferDisplay = document.getElementById('buffer-display');
    const bufferBadge = document.getElementById('buffer-badge');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    // --- State ---
    let channels = [];
    let hls = null;
    let currentChannel = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000;
    let stallTimer = null;
    let lastCurrentTime = 0;
    let stallCount = 0;
    let bufferUpdateTimer = null;

    // --- Buffer config (persisted) ---
    // Segments on this stream are 5 s each — buffer must be >5 s to hold even
    // 1 segment ahead. Default 15 s = 3 segments, giving enough headroom.
    const BUFFER_MIN = 5;
    const BUFFER_MAX = 60;
    const BUFFER_DEFAULT = 15;

    function getBufferSec() {
        const saved = parseInt(localStorage.getItem('buffer_sec'), 10);
        // Discard any saved value below the new minimum (old 5s default was too small)
        if (!saved || saved < BUFFER_MIN) return BUFFER_DEFAULT;
        return Math.min(saved, BUFFER_MAX);
    }

    function setBufferSec(val) {
        const clamped = Math.max(BUFFER_MIN, Math.min(BUFFER_MAX, val));
        localStorage.setItem('buffer_sec', clamped);
        bufferSlider.value = clamped;
        bufferDisplay.textContent = clamped;
        return clamped;
    }

    // Init slider
    const savedBuffer = getBufferSec();
    bufferSlider.value = savedBuffer;
    bufferDisplay.textContent = savedBuffer;

    bufferSlider.addEventListener('input', () => {
        const val = setBufferSec(parseInt(bufferSlider.value, 10));
        // Restart stream with new buffer if a channel is playing
        if (currentChannel) {
            playChannel(currentChannel);
        }
    });

    // --- Settings panel toggle ---
    settingsBtn.addEventListener('click', () => {
        settingsPanel.classList.toggle('hidden');
    });

    // --- Status helpers ---
    function setStatus(state, msg) {
        statusDot.className = 'status-dot ' + state;
        statusText.textContent = msg;
    }

    // --- Custom loader: routes ALL external URLs through our proxy ---
    // This runs in the browser, so hls.js never sees proxy URLs in the playlist —
    // it only ever sees original stream URLs, which this loader wraps before fetching.
    const BaseLoader = Hls.DefaultConfig.loader;
    class ProxyLoader extends BaseLoader {
        load(context, config, callbacks) {
            const url = context.url;
            // Wrap any absolute http(s) URL through our server proxy
            if (/^https?:\/\//i.test(url)) {
                context.url = `/proxy?url=${encodeURIComponent(url)}`;
            }
            super.load(context, config, callbacks);
        }
    }

    // --- HLS instance factory ---
    function createHls() {
        const bufSec = getBufferSec();
        // Segments are 5 s each — need at least 3 segments (15 s) ahead for smooth play
        const segDur = 5;
        const minSync = Math.ceil(bufSec / segDur);  // how many segments to stay behind live

        return new Hls({
            loader: ProxyLoader,

            // Buffer: hold bufSec worth of segments, allow up to 4× to build headroom
            maxBufferLength: bufSec,
            maxMaxBufferLength: bufSec * 4,
            maxBufferSize: 50 * 1000 * 1000,   // 50 MB — segments are large
            backBufferLength: 0,                // no back-buffer for live TV

            // Tolerate small gaps between segments (common with TS streams)
            maxBufferHole: 1,
            maxSeekHole: 3,

            // Stay far enough behind live edge to download comfortably
            // liveSyncDurationCount × segmentDuration = how far behind live we play
            liveSyncDurationCount: Math.max(3, minSync),
            liveMaxLatencyDurationCount: Math.max(10, minSync * 3),
            lowLatencyMode: false,

            enableWorker: true,
            startLevel: -1,                     // auto quality

            // Timeout per attempt — give each try up to 12 s (proxy + upstream)
            fragLoadingTimeOut: 12000,
            manifestLoadingTimeOut: 12000,
            levelLoadingTimeOut: 12000,
            // Fail fast: only 1 retry per fragment — on the 2nd failure we jump
            // to the live edge ourselves rather than hammering a stale URL.
            fragLoadingMaxRetry: 1,
            manifestLoadingMaxRetry: 3,
            levelLoadingMaxRetry: 3,
            fragLoadingRetryDelay: 1000,
            fragLoadingMaxRetryTimeout: 4000,
        });
    }

    // --- Stall watchdog ---
    function startStallWatchdog() {
        stopStallWatchdog();
        lastCurrentTime = video.currentTime;
        stallCount = 0;

        stallTimer = setInterval(() => {
            if (video.paused || video.ended) {
                lastCurrentTime = video.currentTime;
                stallCount = 0;
                return;
            }

            // How much video is buffered AHEAD of current position?
            let bufferAhead = 0;
            for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) <= video.currentTime + 0.5 &&
                    video.buffered.end(i) > video.currentTime) {
                    bufferAhead = video.buffered.end(i) - video.currentTime;
                    break;
                }
            }

            if (video.currentTime === lastCurrentTime) {
                if (bufferAhead < 0.5) {
                    // No data ahead — this is normal live buffering between segments.
                    // hls.js is downloading; don't interfere. Just reset so we don't
                    // count these ticks as stall time.
                    stallCount = 0;
                } else {
                    // Data exists in buffer but playback isn't advancing — true stall.
                    stallCount++;
                    if (stallCount >= 3) {   // 3 × 2 s = 6 s frozen with buffer available
                        stallCount = 0;
                        console.warn('[StreamVibe] True stall — buffer has data but video frozen');
                        setStatus('warn', 'Recovering…');
                        recoverFromStall();
                    }
                }
            } else {
                stallCount = 0;
            }

            lastCurrentTime = video.currentTime;
        }, 2000);
    }

    function stopStallWatchdog() {
        clearInterval(stallTimer);
        stallTimer = null;
    }

    function recoverFromStall() {
        if (!hls) return;
        hls.startLoad();
        video.play().catch(() => {});
    }

    // Skip past stuck segments by jumping to the live sync position and
    // restarting the load. hls.js will fetch a fresh manifest and pick up
    // current segment URLs rather than retrying the stale hung one.
    function jumpToLive() {
        if (!hls) return;
        setStatus('warn', 'Skipping to live…');
        const livePos = hls.liveSyncPosition;
        if (livePos && Number.isFinite(livePos) && livePos > (video.currentTime || 0)) {
            video.currentTime = livePos;
        }
        hls.stopLoad();
        setTimeout(() => {
            hls.startLoad();
            video.play().catch(() => {});
        }, 500);
    }

    // --- Buffer level display ---
    function startBufferUpdate() {
        clearInterval(bufferUpdateTimer);
        bufferUpdateTimer = setInterval(() => {
            if (!video.buffered.length) {
                bufferBadge.textContent = '—';
                bufferBadge.className = 'buffer-badge';
                return;
            }
            const ahead = Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime);
            bufferBadge.textContent = ahead.toFixed(1) + 's';
            if (ahead < 1) bufferBadge.className = 'buffer-badge danger';
            else if (ahead < 3) bufferBadge.className = 'buffer-badge warn';
            else bufferBadge.className = 'buffer-badge good';
        }, 1000);
    }

    function stopBufferUpdate() {
        clearInterval(bufferUpdateTimer);
        bufferUpdateTimer = null;
        bufferBadge.textContent = '—';
        bufferBadge.className = 'buffer-badge';
    }

    // --- Reconnect ---
    function scheduleReconnect() {
        clearTimeout(reconnectTimer);
        setStatus('warn', `Reconnecting in ${Math.round(reconnectDelay / 1000)}s…`);
        reconnectTimer = setTimeout(() => {
            if (currentChannel) {
                console.log(`[StreamVibe] Reconnecting (delay was ${reconnectDelay}ms)`);
                playChannel(currentChannel);
            }
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        }, reconnectDelay);
    }

    function resetReconnect() {
        reconnectDelay = 2000;
        clearTimeout(reconnectTimer);
    }

    // --- Play channel ---
    function playChannel(channel) {
        currentChannel = channel;
        clearTimeout(reconnectTimer);
        stopStallWatchdog();
        stopBufferUpdate();
        loadingOverlay.classList.remove('hidden');
        setStatus('loading', 'Connecting…');

        currentChannelInfo.classList.remove('hidden');
        currentChannelLogo.src = channel.logo;
        currentChannelName.textContent = channel.name;
        currentChannelGroup.textContent = channel.group;

        if (Hls.isSupported()) {
            if (hls) hls.destroy();
            hls = createHls();

            // Pass the original URL — ProxyLoader wraps it through /proxy automatically
            hls.loadSource(channel.url);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                loadingOverlay.classList.add('hidden');
                setStatus('live', 'Live');
                resetReconnect();
                video.play().catch(() => {});
                startStallWatchdog();
                startBufferUpdate();
            });

            let fragFailCount = 0;

            hls.on(Hls.Events.ERROR, (event, data) => {
                console.warn('[StreamVibe] HLS error', data.type, data.details, 'fatal:', data.fatal);

                if (!data.fatal) {
                    // Non-fatal fragment errors: the segment request timed out or
                    // errored. After 2 consecutive failures jump to the live edge —
                    // this discards the stale signed segment URL and forces hls.js
                    // to reload the manifest and pick up fresh segment URLs.
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR &&
                        (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
                         data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT)) {
                        fragFailCount++;
                        setStatus('warn', `Segment failed (${fragFailCount})…`);
                        if (fragFailCount >= 2) {
                            fragFailCount = 0;
                            console.warn('[StreamVibe] Repeated fragment failures → jumping to live edge');
                            jumpToLive();
                        }
                    }
                    return;
                }

                // Fatal errors
                fragFailCount = 0;
                loadingOverlay.classList.add('hidden');

                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        setStatus('warn', 'Network error — retrying…');
                        hls.startLoad();
                        setTimeout(() => { if (currentChannel) scheduleReconnect(); }, 5000);
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        setStatus('warn', 'Media error — recovering…');
                        hls.recoverMediaError();
                        break;
                    default:
                        setStatus('error', 'Stream error');
                        scheduleReconnect();
                        break;
                }
            });

            // Reset fragment fail counter whenever a segment loads successfully
            hls.on(Hls.Events.FRAG_LOADED, () => { fragFailCount = 0; });

        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari native HLS — no custom loader, so we proxy manually
            video.src = `/proxy?url=${encodeURIComponent(channel.url)}`;
            video.addEventListener('loadedmetadata', () => {
                loadingOverlay.classList.add('hidden');
                setStatus('live', 'Live');
                video.play();
                startStallWatchdog();
                startBufferUpdate();
            }, { once: true });
            video.addEventListener('error', () => {
                setStatus('error', 'Stream error');
                scheduleReconnect();
            }, { once: true });
        }
    }

    // --- M3U parsing ---
    function parseM3u(content) {
        channels = [];
        const lines = content.split('\n');
        let meta = null;

        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;

            if (line.startsWith('#EXTINF:')) {
                const logoMatch = line.match(/tvg-logo="([^"]*)"/);
                const nameMatch = line.match(/tvg-name="([^"]*)"/);
                const groupMatch = line.match(/group-title="([^"]*)"/);
                const commaIdx = line.lastIndexOf(',');
                const title = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : 'Unknown';

                meta = {
                    logo: logoMatch?.[1] || 'https://placehold.co/48x48?text=TV',
                    name: nameMatch?.[1] || title,
                    group: groupMatch?.[1] || 'Uncategorized',
                };
            } else if (!line.startsWith('#') && meta) {
                meta.url = line;
                channels.push(meta);
                meta = null;
            }
        }

        renderChannels(channels);
        channelCountEl.textContent = channels.length;
    }

    function renderChannels(list) {
        channelListEl.innerHTML = '';
        if (list.length === 0) {
            channelListEl.innerHTML = '<div class="empty-state"><p>No channels found.</p></div>';
            return;
        }

        list.forEach(channel => {
            const item = document.createElement('div');
            item.className = 'channel-item';
            item.innerHTML = `
                <img src="${channel.logo}" alt="${channel.name}"
                     onerror="this.src='https://placehold.co/48x48?text=TV'">
                <div class="channel-info">
                    <h3>${channel.name}</h3>
                    <p>${channel.group}</p>
                </div>
            `;
            item.addEventListener('click', () => {
                document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                playChannel(channel);
            });
            channelListEl.appendChild(item);
        });
    }

    // --- Load playlist button ---
    loadBtn.addEventListener('click', async () => {
        const url = m3uUrlInput.value.trim();
        if (!url) return;
        try {
            loadBtn.innerHTML = '<span>Loading…</span>';
            loadBtn.disabled = true;
            const response = await fetch(`/proxy?url=${encodeURIComponent(url)}&rewrite=false`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            localStorage.setItem('saved_m3u', text);
            parseM3u(text);
        } catch (err) {
            alert('Error loading M3U: ' + err.message);
        } finally {
            loadBtn.innerHTML = '<span>Load Playlist</span>';
            loadBtn.disabled = false;
        }
    });

    // --- Search ---
    searchInput.addEventListener('input', e => {
        const q = e.target.value.toLowerCase();
        renderChannels(channels.filter(c =>
            c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
        ));
    });

    // --- Init ---
    const defaultM3U = `#EXTM3U
#EXTINF:-1 tvg-logo="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQE5sK1VCxc1PZxV0-f2DlNZHPWSgwHs5R8jw&s" tvg-name="🇰🇭 HONG MEAS" group-title="ប៉ុស្តិ៍ខ្មែរ | KHMER TV 🇰🇭",🇰🇭 HONG MEAS
http://43.252.18.195:54321/hls/HANGMEASHD.m3u8`;

    const saved = localStorage.getItem('saved_m3u');
    parseM3u(saved || defaultM3U);
});
