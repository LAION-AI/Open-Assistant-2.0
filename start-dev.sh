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

# Start Backend
echo "Starting Go Proxy Backend (port 8080)..."
cd backend
go run main.go &
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
