pipeline {
    agent any

    environment {
        DEPLOY_DIR  = "${HOME}/live-tv-deploy"
        PM2_HOME    = "/var/lib/jenkins/.pm2"
        APP_NAME    = "live-tv"
        NODE_ENV    = "production"
    }

    options {
        // Discard old builds; keep last 10 logs
        buildDiscarder(logRotator(numToKeepStr: '10'))
        // Abort if the whole pipeline takes more than 10 minutes
        timeout(time: 10, unit: 'MINUTES')
        // Prevent concurrent deploys clobbering each other
        disableConcurrentBuilds()
        timestamps()
    }

    stages {
        stage('Checkout') {
            steps {
                echo "Branch: ${env.GIT_BRANCH} | Commit: ${env.GIT_COMMIT?.take(7)}"
            }
        }

        stage('Install Dependencies') {
            steps {
                echo 'Installing dependencies...'
                // Install ALL dependencies (including dev) so we can run tests and linter
                sh 'npm install'
            }
        }

        stage('Test & Lint') {
            steps {
                echo 'Running tests and linter...'
                // Remove whichever you don't have; add `|| true` temporarily to unblock while writing tests
                sh 'npm test'
                sh 'npm run lint'
            }
        }

        stage('Deploy') {
            steps {
                echo "Deploying commit ${env.GIT_COMMIT?.take(7)} to ${DEPLOY_DIR}..."
                sh '''
                    set -euo pipefail

                    # Sync only what changed; --delete removes stale files in dest
                    # Exclude node_modules — we'll install fresh in DEPLOY_DIR
                    rsync -a --delete \
                        --exclude='.git' \
                        --exclude='node_modules' \
                        --exclude='.env*' \
                        ./ "${DEPLOY_DIR}/"

                    cd "${DEPLOY_DIR}"

                    # Install production deps in the deploy location
                    npm ci --omit=dev

                    # Gracefully reload if already running, otherwise start fresh.
                    # `pm2 reload` does zero-downtime restart (keeps old process alive
                    # until new one is ready), unlike `pm2 restart` which kills first.
                    if pm2 describe "${APP_NAME}" > /dev/null 2>&1; then
                        pm2 reload "${APP_NAME}" --update-env
                    else
                        pm2 start server.js --name "${APP_NAME}"
                    fi

                    pm2 save
                    sleep 3
                    pm2 logs "${APP_NAME}" --nostream --lines 20
                    echo "Deploy complete."
                '''
            }
        }
    }

    post {
        success {
            echo "✅ Build #${env.BUILD_NUMBER} deployed successfully."
            // Uncomment to add Slack/email notifications:
            // slackSend channel: '#deploys', message: "✅ ${APP_NAME} #${env.BUILD_NUMBER} deployed"
        }
        failure {
            echo "❌ Build #${env.BUILD_NUMBER} failed. Check logs: ${env.BUILD_URL}"
            // slackSend channel: '#deploys', color: 'danger', message: "❌ ${APP_NAME} #${env.BUILD_NUMBER} failed"
        }
        always {
            // Clean Jenkins workspace after each run to avoid disk bloat
            cleanWs()
        }
    }
}