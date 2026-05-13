# Changelog

All notable changes to the "Antigravity Hub" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [0.1.4] - 2026-05-13

### Improved
- **Settings Panel**: Improved auto-refresh controls - clearer toggle states and preset interval options.

## [0.1.3] - 2026-05-13

### Added
- **Session Re-authentication**: "Re-sign in" button for expired sessions — no need to remove and re-add accounts.
- **Encrypted Backups**: Backup files are now password-encrypted. Legacy unencrypted imports still supported.
- **Auto-Refresh Settings**: Configurable automatic balance refresh with enable/disable toggle and customizable interval (default: 15 minutes). Available in both VS Code settings and the in-panel settings modal.
- **Active-Only Refresh**: When auto-refresh is disabled, only the active account's balance is updated on panel open (if stale for 5+ minutes).
- **Editor Compatibility Check**: The extension now detects whether it's running inside Antigravity. Non-Antigravity editors display a dedicated screen with a download link instead of the full panel.

### Fixed
- **Active Account Display**: Fixed a bug where cancelling a balance refresh caused the active account to temporarily lose its active status and be treated as a normal account.
- **Active Account Detection**: Active account now correctly detected on launch regardless of how it was activated.
- **Cancel Dialog**: Cancel confirmation dialog buttons are no longer disabled during refresh — they now respond to clicks as expected.
- **Cancel Flow**: Confirming cancellation now shows a "Cancelling..." loading state while waiting for the current account to finish, then applies sorting and shows a completion toast.

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
