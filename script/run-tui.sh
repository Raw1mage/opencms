#!/bin/bash
# @event_2026-02-07_terminal-cleanup: Wrapper that ensures terminal reset on exit
trap reset EXIT
"$@"
