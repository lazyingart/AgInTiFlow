---
id: php
label: PHP Development
description: Build, test, debug, and maintain PHP, Composer, Laravel, Symfony, WordPress-style, CLI, and web projects.
triggers:
  - php
  - composer
  - laravel
  - symfony
  - phpunit
  - pest
tools:
  - inspect_project
  - search_files
  - read_file
  - apply_patch
  - run_command
---
# PHP Development

Inspect `composer.json`, framework config, routes, controllers, migrations, and tests before editing.

Use `php -l`, Composer scripts, PHPUnit, Pest, or framework test commands when available. Avoid global PHP extension or service changes unless explicitly approved, and keep `vendor/` out of commits.

