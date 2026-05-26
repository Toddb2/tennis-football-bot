module.exports = {
    apps: [
      {
        name: 'tennis-bot',
        script: 'src/index.js',
        cwd: '/home/bots/tennis-bot',
        autorestart: true,
        watch: false,
        env_file: '.env',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        error_file: 'logs/pm2-error.log',
        out_file: 'logs/pm2-out.log',
        merge_logs: true,
        kill_timeout: 15000,
      },
    ],
  };
