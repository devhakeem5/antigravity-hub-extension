# Changelog

All notable changes to the "Antigravity Hub" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-05-11

### Added
- **Session Re-authentication**: "Re-sign in" button for expired sessions — no need to remove and re-add accounts.
- **Encrypted Backups**: Backup files are now password-encrypted. Legacy unencrypted imports still supported.

### Fixed
- **Active Account Detection**: Active account now correctly detected on launch regardless of how it was activated.

### Changed
- **Inline Balance Refresh**: Per-account loading indicator replaces the full-screen overlay. Buttons are disabled during refresh with a cancellable confirmation dialog.
- Expired accounts now have a distinct visual warning style.

### Security
- **Device Fingerprint Isolation**: Each account gets a fully unique set of telemetry identifiers to prevent cross-account correlation.
- Re-authentication now verifies email match to prevent accidental account mix-ups.

## [0.1.2] - 2026-05-10

### Added
- **Profile Pictures**: Account avatars are now displayed in the sidebar.

### Improved
- **Active Account Sync**: Active account is detected from Antigravity's internal state and pinned to the top of the list.

## [0.1.1] - 2026-05-09

### Added
- Initial release with core account management, OAuth login, multi-language support (EN/AR), and VS Code theme integration.
