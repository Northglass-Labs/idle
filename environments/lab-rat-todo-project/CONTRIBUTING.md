# Contribution Guide

This directory contains a small frontend-only todo app. It has no build step or
dependencies, opens through `index.html`, and stores tasks in localStorage.

- Keep changes small and dependency-free.
- Preserve keyboard and screen-reader accessibility.
- Preserve localStorage compatibility when changing the task shape.
- Verify the add, toggle, filter, delete, and clear-completed flows manually.
- Read and write only within this sample-project directory.

The intentionally incorrect completed-items filter is a useful first issue for
new contributors.
