import os

from backend import config, create_app


app = create_app()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=config.DEBUG_ENABLED, port=port, host='0.0.0.0')
