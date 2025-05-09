# Changelog

All notable changes to the MCP Component Harvester will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2025-05-09

### Added
- shadcn UI support
  - Added new tools for interacting with shadcn UI components:
    - `scan_shadcn_component` - Scans and stores shadcn UI components
    - `list_shadcn_components` - Lists all available shadcn UI components
    - `get_shadcn_component_prompt` - Generates integration prompts for shadcn components
  - Added shadcn registry data cache
  - Implemented functions to fetch and process shadcn components
  - Updated README.md with shadcn UI compatibility and example prompts

## [0.1.0] - 2025-05-09

### Added
- Initial release with Aceternity UI support
  - Tools for scanning, listing, and generating prompts for Aceternity UI components
  - Registry parsing for Aceternity UI components
  - Component storage in JSON format
  - Detailed integration prompts for React projects
