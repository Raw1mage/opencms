---
name: flask-api
description: Flask web application development including REST API routes, Jinja2 templates, blueprints, and common patterns. Use when building or debugging Flask backends, API endpoints, or server-rendered templates.
---

# Flask API Skill

Build Flask web applications and REST APIs.

## Project Structure

```
webapp/
├── app.py              # Entry point, create_app()
├── core/
│   ├── __init__.py
│   ├── api.py          # API routes blueprint
│   ├── config.py       # Configuration
│   └── models.py       # Data models
├── templates/          # Jinja2 templates
│   ├── base.html
│   └── pages/
└── static/             # CSS, JS, images
```

## Quick Reference

### Basic App

```python
from flask import Flask, jsonify, request, render_template

app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/items', methods=['GET'])
def get_items():
    return jsonify({'items': []})

@app.route('/api/items', methods=['POST'])
def create_item():
    data = request.get_json()
    return jsonify(data), 201
```

### Blueprints

```python
# core/api.py
from flask import Blueprint, jsonify

api = Blueprint('api', __name__, url_prefix='/api')

@api.route('/health')
def health():
    return jsonify({'status': 'ok'})

# app.py
from core.api import api
app.register_blueprint(api)
```

### Request Handling

```python
# Query params: /search?q=foo&limit=10
q = request.args.get('q', '')
limit = request.args.get('limit', 10, type=int)

# JSON body
data = request.get_json()

# Form data
name = request.form.get('name')

# Files
file = request.files.get('upload')
if file:
    file.save(f'/path/{file.filename}')

# Headers
auth = request.headers.get('Authorization')
```

### Response Patterns

```python
# JSON response
return jsonify({'key': 'value'})

# Status code
return jsonify({'error': 'Not found'}), 404

# Custom headers
response = jsonify({'data': 'value'})
response.headers['X-Custom'] = 'header'
return response

# File download
from flask import send_file
return send_file('/path/to/file', as_attachment=True)

# Redirect
from flask import redirect, url_for
return redirect(url_for('index'))
```

### Jinja2 Templates

```html
<!-- base.html -->
<!DOCTYPE html>
<html>
<head>
    <title>{% block title %}{% endblock %}</title>
</head>
<body>
    {% block content %}{% endblock %}
</body>
</html>

<!-- page.html -->
{% extends "base.html" %}
{% block title %}Page Title{% endblock %}
{% block content %}
    <h1>{{ title }}</h1>
    {% for item in items %}
        <p>{{ item.name }}</p>
    {% endfor %}
{% endblock %}
```

### Error Handling

```python
from flask import Flask, jsonify

app = Flask(__name__)

@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def server_error(e):
    return jsonify({'error': 'Internal server error'}), 500

# Raise HTTP errors
from flask import abort
abort(404)  # triggers 404 handler
```

### Configuration

```python
# config.py
import os

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev')
    DEBUG = os.environ.get('DEBUG', 'false').lower() == 'true'

# app.py
app.config.from_object('core.config.Config')
```

### CORS

```python
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Allow all

# Or specific origins
CORS(app, origins=['http://localhost:3000'])
```

## Common Patterns

### Nginx X-Accel-Redirect (NAS Streaming)

```python
from flask import Response

@app.route('/stream/<path:filepath>')
def stream(filepath):
    # Validate filepath...
    return Response(headers={
        'X-Accel-Redirect': f'/protected/{filepath}',
        'Content-Type': 'video/mp4'
    })
```

### Background Tasks

```python
import threading

def background_task(data):
    # Long running task
    pass

@app.route('/api/process', methods=['POST'])
def process():
    data = request.get_json()
    thread = threading.Thread(target=background_task, args=(data,))
    thread.start()
    return jsonify({'status': 'processing'}), 202
```

### Request Context

```python
from flask import g, request

@app.before_request
def before():
    g.user = get_user_from_token(request.headers.get('Authorization'))

@app.after_request
def after(response):
    response.headers['X-Request-ID'] = g.get('request_id', '')
    return response
```

## Debugging

```python
# Enable debug mode
app.run(debug=True)

# Log requests
import logging
logging.basicConfig(level=logging.DEBUG)

# Print request info
@app.before_request
def log_request():
    app.logger.debug(f'{request.method} {request.path}')
```

## Testing

```python
import pytest
from app import app

@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client

def test_health(client):
    rv = client.get('/api/health')
    assert rv.status_code == 200
    assert rv.get_json()['status'] == 'ok'
```
