# Security

Unknown Core and its modules run as fully trusted root code. Manifest
permissions and read-only labels are declarations, not a security sandbox.
Review source before activation. A module may affect TV operation, local access
or data; a health check is bounded to the paths it inspects. Unknown Core
recovery cannot guarantee restoration after arbitrary root changes, firmware
updates or hardware failure.

Do not expose root listeners or pairing services to the internet. Keep optional
listeners disabled when not needed. Never publish pairing keys, passphrases,
tokens, packet captures or household logs in issues. Contact the repository
owner through an existing private channel, or use GitHub private vulnerability
reporting if enabled for this repository. Do not post sensitive reports in
public issues. No separate security-reporting address is asserted here.

The supplied repository excludes device-specific credentials, TV logs,
firmware, root-acquisition exploits and the private YouTube patch. It does not
authenticate ownership and cannot guarantee that modified versions will not
be abused.
