---
name: playwright-python
description: Playwright browser automation with Python for E2E testing, web scraping, and UI verification. Use when writing Python test scripts, automating browser interactions, or debugging web applications.
---

# Playwright Python Skill

Browser automation and E2E testing with Python.

## Quick Start

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:8080')
    page.wait_for_load_state('networkidle')
    
    # ... test logic
    
    browser.close()
```

## Page Navigation

```python
# Navigate
page.goto('http://example.com')
page.goto('http://example.com', wait_until='networkidle')

# Wait states
page.wait_for_load_state('load')        # DOMContentLoaded
page.wait_for_load_state('domcontentloaded')
page.wait_for_load_state('networkidle')  # No network for 500ms

# Reload
page.reload()

# Back/Forward
page.go_back()
page.go_forward()
```

## Selectors

```python
# CSS selector
page.locator('button.submit')
page.locator('#my-id')
page.locator('[data-testid="login"]')

# Text selector
page.locator('text=Submit')
page.get_by_text('Submit')

# Role selector
page.get_by_role('button', name='Submit')
page.get_by_role('link', name='Home')

# Label/Placeholder
page.get_by_label('Email')
page.get_by_placeholder('Enter email')

# Test ID
page.get_by_test_id('submit-btn')
```

## Actions

```python
# Click
page.click('button')
page.locator('button').click()

# Fill input
page.fill('input[name="email"]', 'test@example.com')
page.locator('input').fill('value')

# Type (with delay)
page.type('input', 'hello', delay=100)

# Select dropdown
page.select_option('select', 'value')
page.select_option('select', label='Option 1')

# Checkbox/Radio
page.check('input[type="checkbox"]')
page.uncheck('input[type="checkbox"]')

# Hover
page.hover('button')

# Drag and drop
page.drag_and_drop('#source', '#target')

# Keyboard
page.keyboard.press('Enter')
page.keyboard.press('Control+a')
page.keyboard.type('Hello')

# File upload
page.set_input_files('input[type="file"]', '/path/to/file.png')
```

## Waiting

```python
# Wait for selector
page.wait_for_selector('.loaded')
page.wait_for_selector('.loaded', state='visible')
page.wait_for_selector('.loading', state='hidden')

# Wait for timeout
page.wait_for_timeout(1000)  # 1 second

# Wait for function
page.wait_for_function('window.ready === true')

# Wait for navigation
with page.expect_navigation():
    page.click('a')

# Wait for response
with page.expect_response('**/api/data'):
    page.click('button')
```

## Assertions

```python
from playwright.sync_api import expect

# Visibility
expect(page.locator('button')).to_be_visible()
expect(page.locator('.modal')).to_be_hidden()

# Text content
expect(page.locator('h1')).to_have_text('Welcome')
expect(page.locator('p')).to_contain_text('hello')

# Attributes
expect(page.locator('input')).to_have_value('test')
expect(page.locator('a')).to_have_attribute('href', '/home')

# Count
expect(page.locator('li')).to_have_count(5)

# URL
expect(page).to_have_url('http://example.com/page')
expect(page).to_have_title('Page Title')
```

## Screenshots & Debugging

```python
# Screenshot
page.screenshot(path='screenshot.png')
page.screenshot(path='full.png', full_page=True)
page.locator('.element').screenshot(path='element.png')

# Video recording
browser = p.chromium.launch()
context = browser.new_context(record_video_dir='videos/')
page = context.new_page()
# ... actions
context.close()  # Video saved on close

# Trace (for debugging)
context = browser.new_context()
context.tracing.start(screenshots=True, snapshots=True)
# ... actions
context.tracing.stop(path='trace.zip')
# View: npx playwright show-trace trace.zip
```

## Console & Network

```python
# Capture console logs
page.on('console', lambda msg: print(f'Console: {msg.text}'))

# Capture errors
errors = []
page.on('pageerror', lambda err: errors.append(str(err)))

# Network interception
def handle_route(route):
    if 'analytics' in route.request.url:
        route.abort()
    else:
        route.continue_()

page.route('**/*', handle_route)

# Wait for specific request
with page.expect_request('**/api/save') as request_info:
    page.click('button[type="submit"]')
request = request_info.value
print(request.post_data)
```

## SPA Testing Pattern

For single-page apps with persistent elements:

```python
def test_spa_navigation():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        
        page.goto('http://localhost:8080')
        page.wait_for_load_state('networkidle')
        
        # Navigate via SPA
        page.click('a[href="/page2"]')
        page.wait_for_load_state('networkidle')
        
        # Verify no JS errors
        assert len(errors) == 0, f"JS Errors: {errors}"
        
        # Verify persistent element still exists
        expect(page.locator('#player')).to_be_visible()
        
        browser.close()
```

## with_server.py Integration

Use the helper script for managed server lifecycle:

```bash
python scripts/with_server.py \
  --server "./webctl.sh up" \
  --port 60108 \
  -- python scripts/test_spa.py
```

Test script only needs Playwright logic:

```python
# test_spa.py
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:60108')  # Server already running
    # ... test logic
    browser.close()
```

## Troubleshooting

### Timeout Issues

```python
# Increase default timeout
page.set_default_timeout(60000)  # 60 seconds

# Per-action timeout
page.click('button', timeout=10000)
```

### Element Not Found

```python
# Debug: print page content
print(page.content())

# Debug: screenshot before action
page.screenshot(path='debug.png')

# Check if element exists
if page.locator('button').count() > 0:
    page.click('button')
```

### Headless vs Headed

```python
# Run with visible browser for debugging
browser = p.chromium.launch(headless=False, slow_mo=500)
```
