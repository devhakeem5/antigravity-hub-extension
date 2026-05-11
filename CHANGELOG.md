# Changelog

All notable changes to the "Antigravity Hub" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-05-11

### Added
- **Session Re-authentication**: Easily restore access to accounts with expired sessions via a new "Re-sign in" button, eliminating the need to re-add accounts.

### Security
- **Encrypted Backups**: Exported backup files are now securely encrypted with a user-chosen password to protect sensitive account data.
- **Strict Verification**: Added safety checks during re-authentication to prevent accidental account mix-ups.

### Changed
- Improved UI visibility for expired accounts with a distinct warning style.
- Legacy unencrypted backups remain supported for import, but will display a security warning.

## [0.1.2] - 2026-05-10

### Added
- **Profile Pictures**: User profile images are now fetched and displayed alongside each account in the account manager sidebar for better visual identification.

### Improved
- **Active Account Synchronization**: Enhanced the accuracy of active account detection to perfectly synchronize with Antigravity in real-time, even when accounts are switched externally. The active account is now automatically pinned to the top of the list.

## [0.1.1] - 2026-05-09

### Added
- Initial public release of Antigravity Hub with core account management features.
- OAuth-based login and token management.
- Multi-language support (English and Arabic).
- Custom UI themes matching VS Code.
