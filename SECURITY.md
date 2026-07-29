# Security policy

## Supported versions

Only the latest Marketplace release receives security fixes.

## Reporting a vulnerability

Please use GitHub’s private vulnerability reporting for this repository. Do
not open a public issue containing an exploit, credential, private repository
content, or other sensitive data.

GitLoupe treats commit metadata, file paths, remote responses, and webview
messages as untrusted input. Ollama requests are restricted to loopback or
private-network addresses by default, and optional gateway keys are stored in
VS Code SecretStorage.
