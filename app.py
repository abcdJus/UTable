import os

from backend.app import APP_ENV, app, env_flag


if __name__ == '__main__':
    app.run(
        host='0.0.0.0',
        port=int(os.environ.get('PORT', '5000')),
        debug=env_flag('FLASK_DEBUG', APP_ENV == 'development'),
    )
