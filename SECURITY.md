# Security

This module runs as fully trusted root code under Unknown Core. Manifest
permissions and read-only labels are declarations, not a security sandbox.
Review source before activation. A module may affect TV operation, local access
or data; a health check is bounded to the paths it inspects. Unknown Core
recovery cannot guarantee restoration after arbitrary root changes, firmware
updates or hardware failure.

Do not expose root listeners or pairing services to the internet. Keep optional
listeners disabled when not needed. Never publish pairing keys, passphrases,
tokens, packet captures or household logs in issues. Contact the repository
owner through an existing private channel for this private review candidate.
No public security-reporting address is invented here.

The supplied repository excludes device-specific credentials, TV logs,
firmware, root-acquisition exploits and the private YouTube patch. It does not
authenticate ownership and cannot guarantee that modified versions will not
be abused.
