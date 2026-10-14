# REA setup and diagnostics

## Installed setup

On 2026-10-13, the Windows x64 machine had Microsoft OpenJDK 17.0.19 on PATH and REA 6.4.0 registered in Codex. Java 17 was retained.

- Temurin JDK 21.0.12.1+1 (64-bit): C:\tools\jdk-21.0.12.1+1
- Ghidra 12.1.4: C:\tools\ghidra_12.1.4_PUBLIC
- User environment: JAVA_HOME, GHIDRA_INSTALL_DIR, and REA_ANALYSIS_PROVIDER=ghidra
- Codex MCP environment: the same variables were added to the existing mcp_servers.rea entry in C:\Users\competitor\.codex\config.toml. The original command, arguments, and other MCP entries were preserved.
- Configuration backup: C:\Users\competitor\.codex\config.toml.pre-ghidra.bak

Downloads came from the official [Temurin JDK 21 releases](https://adoptium.net/temurin/releases/?arch=any&package=jdk&version=21) and [NSA Ghidra 12.1.4 release](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build). The JDK archive SHA-256 matched its official sidecar: f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e. Ghidra matched the release SHA-256: ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db.

The REA setup dry run reported zero planned changes and Codex as already configured, so setup was not applied again. Its existing registration was kept and only the provider environment was added.

## Verification

The requested commands were run with the new provider environment:

- npx -y rea-agents@latest doctor --provider ghidra --json: exit 0; Ghidra was configured and available at 12.1.4. The x64 native decompiler, Windows x64 host check, and 64-bit full JDK check all passed.
- npx -y rea-agents@latest providers --json: Ghidra reported available. Hopper is unsupported on Windows and IDA is unconfigured.
- npx -y rea-agents@latest setup --client codex --dry-run --json: Codex remained configured; zero actions were planned.

The doctor reported healthy=true for the requested Ghidra provider, but environment_healthy=false because unrelated optional providers and other detected MCP clients are not configured. This does not indicate a Ghidra failure.

A locally authored x64 PE test executable was built with the installed Visual Studio Build Tools and analyzed through a separately launched REA MCP server with the new environment. Ghidra identified probe_leaf and probe_compose, returned x64 disassembly and decompiled pseudocode for probe_compose, and reported its call to probe_leaf at 0x140001000. The executable source and output are in the Windows temporary directory, not the repository. The target was closed after analysis.

A fresh REA MCP process also opened the same PE without an explicit provider_id and reported Ghidra 12.1.4 as selected from the REA_ANALYSIS_PROVIDER environment variable.

## Restart requirement and limits

The active Codex REA server was started before the provider variables were changed. Its live binary_session still detects Java 17.0.19 and no GHIDRA_INSTALL_DIR, even though the new configuration and a fresh REA process both pass the provider checks. Restart Codex to reload the updated MCP environment. The persistent user environment and Codex configuration are already set.

See [hancom-binary-survey.md](hancom-binary-survey.md) for the installed Hanword 2024 binary survey and its analysis limits. No Hancom binaries, proprietary resources, or private documents were copied into the repository.
