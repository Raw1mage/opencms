---
name: wordpress-pro
description: "Expert WordPress development skill covering custom themes, plugins, Gutenberg blocks, WooCommerce, REST API, security hardening, and performance optimization."
version: "1.1.0"
---

# WordPress Pro Skill

Expert-level WordPress development across themes, plugins, Gutenberg blocks, WooCommerce, and performance optimization.

## Key Responsibilities

- Custom theme and plugin architecture
- Gutenberg block creation and patterns
- WooCommerce store configuration
- REST API endpoint implementation
- Security hardening via nonces, sanitization, and capability checks
- Performance tuning through caching and query optimization

## Core Workflow

1. **Requirements Analysis** - Understand scope and constraints
2. **Architectural Design** - Plan structure following WordPress standards
3. **Implementation** - Code using WordPress coding standards
4. **Validation** - Run phpcs, optimize for speed
5. **Testing** - Comprehensive testing with security audits

## Critical Security Patterns

### Nonce Verification
All form submissions must use nonces:
```php
wp_nonce_field('action_name', 'nonce_field');
// Verification
if (!wp_verify_nonce($_POST['nonce_field'], 'action_name')) {
    wp_die('Security check failed');
}
```

### Input Sanitization
- `sanitize_text_field()` for text inputs
- `wp_kses_post()` for rich content
- `absint()` for integers
- `sanitize_email()` for emails

### Output Escaping
- `esc_html()` for HTML content
- `esc_url()` for URLs
- `esc_attr()` for HTML attributes
- `wp_kses()` for allowed HTML

### Database Safety
- Always use `$wpdb->prepare()` for queries with variables
- Never concatenate user input into SQL

### Capability Checks
- `current_user_can()` before privileged operations

## WordPress Database Structure

### Key Tables
- `wp_posts` - All content (posts, pages, custom post types, revisions, nav_menu_items)
- `wp_postmeta` - Post metadata (Elementor data stored as `_elementor_data`)
- `wp_options` - Site settings, widget configs, active plugins/theme
- `wp_terms` / `wp_term_taxonomy` / `wp_term_relationships` - Categories, tags, nav menus
- `wp_users` / `wp_usermeta` - User data

### Important Options (wp_options)
- `siteurl` / `home` - Site URLs
- `active_plugins` - Serialized array of active plugins
- `template` / `stylesheet` - Active theme
- `nav_menu_locations` - Menu assignments
- `sidebars_widgets` - Widget assignments

### Elementor Data
- Page content stored in `wp_postmeta` with key `_elementor_data`
- Contains JSON with widget configs, styles, and content
- `_elementor_page_settings` for page-level settings
- CSS cached in `wp-content/uploads/elementor/css/`

### Navigation Menus
- Menu items stored as `wp_posts` with `post_type = 'nav_menu_item'`
- Menu structure in `wp_postmeta` (menu_item_parent, menu_item_type, etc.)
- Menu-to-location mapping in `wp_options` → `nav_menu_locations`

## Non-Negotiable Standards

**NEVER:**
- Modify WordPress core files
- Trust unsanitized input
- Output unescaped data
- Hardcode table names (use `$wpdb->prefix`)
- Skip internationalization

**ALWAYS:**
- Follow WordPress Coding Standards
- Support PHP 8.1+ and WordPress 6.4+
- Use hooks (actions/filters) for extensibility
- Prefix all functions, classes, and global variables
