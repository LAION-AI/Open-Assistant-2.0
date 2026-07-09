#!/bin/bash

# Function to clean up background processes on exit
cleanup() {
    echo ""
    echo "Stopping Open Assistant 2.0 services..."
    # Kill all background jobs started by this script
    kill $(jobs -p) 2>/dev/null
    exit 0
}

# Trap SIGINT (Ctrl+C) and SIGTERM
trap cleanup SIGINT SIGTERM

echo "🚀 Starting Open Assistant 2.0..."

# Ensure we are in the script's directory
cd "$(dirname "$0")"

# Start Backend. Build the whole package first (it has more files than
# main.go) and run the binary directly: unlike `go run`, killing it on Ctrl+C
# can't orphan a child server on port 8080, and the stable binary path keeps
# macOS's "Local Network" grant (same approach as start-prod.sh).
echo "Building & starting Go Proxy Backend (port 8080)..."
cd backend
go build -o oa-backend . && ./oa-backend &
BACKEND_PID=$!
cd ..

# Wait a brief moment for Go backend to start
sleep 1

# Start Frontend
echo "Starting Bun Frontend Dev Server (port 3000)..."
cd frontend
bun run dev &
FRONTEND_PID=$!
cd ..

echo "Both services are running. Press Ctrl+C to stop them."

# Keep script running to capture traps
wait
