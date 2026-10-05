#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -n 1)/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Clean port 3001 if occupied
PORT_PID=$(lsof -t -i :3001 2>/dev/null)
if [ -n "$PORT_PID" ]; then
    kill -9 $PORT_PID 2>/dev/null || true
    sleep 0.5
fi

# Find node
NODE_BIN=""
if [ -x "/usr/local/bin/node" ]; then
    NODE_BIN="/usr/local/bin/node"
elif [ -x "/opt/homebrew/bin/node" ]; then
    NODE_BIN="/opt/homebrew/bin/node"
elif command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
fi

if [ -z "$NODE_BIN" ]; then
    echo "NO_NODE"
    exit 1
fi

nohup "$NODE_BIN" backend/server.js </dev/null >> backend_server.log 2>&1 &
disown

# Wait up to 10 seconds for server
READY=0
for i in {1..20}; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 2>/dev/null || true)
    if [ "$STATUS" = "200" ] || [ "$STATUS" = "304" ]; then
        READY=1
        break
    fi
    sleep 0.5
done

if [ $READY -eq 1 ]; then
    echo "READY"
    exit 0
else
    echo "TIMEOUT"
    exit 1
fi
