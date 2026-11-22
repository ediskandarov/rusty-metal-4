# Map settings

These optional MR resources are validated and copied once during world construction.
Omitted values keep TM4 defaults. Invalid types, lengths or ranges fail loading with
an error naming the setting; there is no binary dump of `Tm4WorldSettings` to maintain.

| Resource under `world/` | Format | Meaning |
| --- | --- | --- |
| `renderSettings/backgroundColor` | Binary, four bytes `R,G,B,0` | Background colour; the GPU command is engine-owned. |

Face budgets use the shared renderer settings; maps do not override them.
Map settings do not change camera projection or the visible-cell radius.

Spawn points use authored X/Y/Z through the unchanged TM4 paths. Converters supply
complete coordinates; no placement policy is stored in the port.

Implementation lives in `port/extensions/map_settings.c`; `map-settings.patch`
connects world loading. Immutable configuration comes from the same resources on
snapshot restore; it is not mutable simulation state and does not consume RNG.
