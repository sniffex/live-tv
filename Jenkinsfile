pipeline {
    // This tells Jenkins to run this pipeline on any available agent/node
    agent any

    // Environment variables can be defined here if needed
    environment {
        // Change this to the actual directory where you want the app to live on the Jenkins server
        DEPLOY_DIR = '/var/www/live-tv'
    }

    stages {
        stage('Checkout') {
            steps {
                // Jenkins automatically checks out the code from GitHub based on the SCM configuration,
                // but we explicitly log it here.
                echo 'Code checked out from GitHub'
            }
        }
        
        stage('Install Dependencies') {
            steps {
                // Jenkins runs this inside its own temporary workspace
                echo 'Installing Node.js dependencies...'
                sh 'npm install'
            }
        }
        
        stage('Deploy') {
            steps {
                echo 'Deploying application...'
                // This script will copy the files from Jenkins' workspace to your live directory
                // and use PM2 to restart the app.
                // NOTE: The Jenkins user needs permissions to write to DEPLOY_DIR and run pm2!
                sh '''
                    # Create the directory if it doesn't exist
                    mkdir -p ${DEPLOY_DIR}
                    
                    # Copy everything from the current Jenkins workspace to the live directory
                    cp -r ./* ${DEPLOY_DIR}/
                    
                    # Navigate to the live directory
                    cd ${DEPLOY_DIR}
                    
                    # Restart the app with PM2, or start it if it's not running
                    # We name the process 'live-tv'
                    pm2 restart live-tv || pm2 start server.js --name "live-tv"
                    
                    echo "Deployment Complete!"
                '''
            }
        }
    }
    
    // Actions to run after the pipeline finishes (e.g., notifications)
    post {
        success {
            echo 'Pipeline completed successfully!'
        }
        failure {
            echo 'Pipeline failed! Check the Jenkins logs.'
        }
    }
}
