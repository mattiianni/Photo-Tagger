#!/bin/bash
PORT_PID=$(lsof -t -i :3001 2>/dev/null)
if [ -n "$PORT_PID" ]; then
    kill -9 $PORT_PID 2>/dev/null || true
fi
