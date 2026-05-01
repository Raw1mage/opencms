# Errors

| Code                         | Message                                                 | Layer                  | Recovery                                                  |
| ---------------------------- | ------------------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| DIALOG_STREAM_RENDER_ERROR   | Stream card could not render                            | Frontend card renderer | Show existing error card; keep data reducer unchanged     |
| STATUS_SURFACE_CONFLICT      | Multiple status surfaces active for the same stream     | Frontend display       | Remove competing footer/status path; use turn status line |
| STREAM_SCROLL_OWNER_CONFLICT | More than one scroll owner controls the embedded stream | Frontend layout        | Keep only DialogStreamCanvas scroll owner                 |
