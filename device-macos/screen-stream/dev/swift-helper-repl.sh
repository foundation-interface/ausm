#!/bin/bash
# Dev-only interactive REPL for the Swift screen-capture-helper binary (not shipped).
# No Node.js/TypeScript dependencies required

BINARY="$(cd "$(dirname "$0")/.." && pwd)/build/screen-capture-helper"
SOCKET="/tmp/ausm-test-helper.sock"
NOTIFY_SOCKET="${SOCKET}.notify"
HELPER_PID=""

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

send_cmd() {
    echo "$1" | nc -U "$SOCKET" 2>/dev/null
}

send_cmd_pretty() {
    local result
    result=$(echo "$1" | nc -U "$SOCKET" 2>/dev/null)
    if [ -z "$result" ]; then
        echo -e "${RED}No response (helper not running?)${NC}"
    else
        echo "$result" | python3 -m json.tool 2>/dev/null || echo "$result"
    fi
}

cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"
    if [ -n "$HELPER_PID" ]; then
        send_cmd '{"command":"quit"}' >/dev/null 2>&1
        sleep 0.5
        kill "$HELPER_PID" 2>/dev/null
        wait "$HELPER_PID" 2>/dev/null
    fi
    if [ -n "$NOTIFY_PID" ]; then
        kill "$NOTIFY_PID" 2>/dev/null
    fi
    rm -f "$SOCKET" "$NOTIFY_SOCKET"
    echo -e "${GREEN}Done.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Check binary exists
if [ ! -x "$BINARY" ]; then
    echo -e "${RED}Binary not found at: $BINARY${NC}"
    echo "Build it first:  npm run build:helper"
    exit 1
fi

# Clean old sockets
rm -f "$SOCKET" "$NOTIFY_SOCKET"

echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       Swift Screen Capture Helper - Interactive Test        ║${NC}"
echo -e "${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}d${NC}              List displays                               ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}c [fps] [h]${NC}    Configure (default: fps=10, height=720)     ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}s${NC}              Start capture                               ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}x${NC}              Stop capture                                ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}i${NC}              Status                                      ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}f <fps>${NC}        Change FPS (e.g. 'f 30')                    ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}h <height>${NC}     Change height (e.g. 'h 1080', 'h 0'=native) ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}dc${NC}             Get display configs                         ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}m${NC}              Memory/CPU stats for helper                 ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}log${NC}            Show recent helper logs                     ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}raw <json>${NC}     Send raw JSON command                       ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${CYAN}q${NC}              Quit                                        ${BOLD}║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Start helper
echo -e "${YELLOW}Starting helper...${NC}"
"$BINARY" --socket "$SOCKET" >/tmp/ausm-helper-test.log 2>&1 &
HELPER_PID=$!

# Wait for socket to appear
for i in $(seq 1 30); do
    if [ -S "$SOCKET" ]; then
        break
    fi
    sleep 0.2
done

if [ ! -S "$SOCKET" ]; then
    echo -e "${RED}Helper failed to start. Check /tmp/ausm-helper-test.log${NC}"
    cat /tmp/ausm-helper-test.log
    exit 1
fi

echo -e "${GREEN}✓ Helper started (PID $HELPER_PID)${NC}"
echo -e "  Log: /tmp/ausm-helper-test.log"
echo ""

# Listen for notifications in background
(
    while true; do
        if [ -S "$NOTIFY_SOCKET" ]; then
            nc -U "$NOTIFY_SOCKET" 2>/dev/null | while IFS= read -r line; do
                echo -e "\n${CYAN}📡 Notification: ${line}${NC}"
                printf "> "
            done
        fi
        sleep 1
    done
) &
NOTIFY_PID=$!

# Current config state
CFG_FPS=10
CFG_HEIGHT=720
CONFIGURED=false

# Main loop
while true; do
    printf "> "
    read -r INPUT
    CMD=$(echo "$INPUT" | awk '{print $1}')
    ARG1=$(echo "$INPUT" | awk '{print $2}')
    ARG2=$(echo "$INPUT" | awk '{print $3}')

    case "$CMD" in
        d)
            echo -e "${CYAN}Displays:${NC}"
            send_cmd_pretty '{"command":"displays"}'
            ;;
        c)
            if [ -n "$ARG1" ]; then CFG_FPS=$ARG1; fi
            if [ -n "$ARG2" ]; then CFG_HEIGHT=$ARG2; fi
            echo -e "${YELLOW}Configuring: fps=$CFG_FPS, targetHeight=$CFG_HEIGHT${NC}"
            send_cmd_pretty "{\"command\":\"configure\",\"config\":{\"fps\":$CFG_FPS,\"targetHeight\":$CFG_HEIGHT,\"sharedMemoryName\":\"/ausm-test\",\"frameCount\":3}}"
            CONFIGURED=true
            ;;
        s)
            if [ "$CONFIGURED" = false ]; then
                echo -e "${YELLOW}Auto-configuring: fps=$CFG_FPS, targetHeight=$CFG_HEIGHT${NC}"
                send_cmd "{\"command\":\"configure\",\"config\":{\"fps\":$CFG_FPS,\"targetHeight\":$CFG_HEIGHT,\"sharedMemoryName\":\"/ausm-test\",\"frameCount\":3}}" >/dev/null
                CONFIGURED=true
            fi
            echo -e "${YELLOW}Starting capture...${NC}"
            send_cmd_pretty '{"command":"start","displayIds":[]}'
            # Wait a moment then check status
            sleep 2
            echo -e "${CYAN}Status after start:${NC}"
            send_cmd_pretty '{"command":"status"}'
            # Show recent log lines
            echo -e "${CYAN}Recent logs:${NC}"
            tail -20 /tmp/ausm-helper-test.log | grep -E "(Started capture|Error|Timeout|AddDisplay|Capture started)"
            ;;
        x)
            echo -e "${YELLOW}Stopping capture...${NC}"
            send_cmd_pretty '{"command":"stop"}'
            ;;
        i)
            echo -e "${CYAN}Status:${NC}"
            send_cmd_pretty '{"command":"status"}'
            ;;
        f)
            if [ -z "$ARG1" ]; then
                echo "Usage: f <fps>"
            else
                CFG_FPS=$ARG1
                echo -e "${YELLOW}Updating FPS to $CFG_FPS...${NC}"
                send_cmd_pretty "{\"command\":\"configure\",\"config\":{\"fps\":$CFG_FPS,\"targetHeight\":$CFG_HEIGHT,\"sharedMemoryName\":\"/ausm-test\",\"frameCount\":3}}"
            fi
            ;;
        h)
            if [ -z "$ARG1" ]; then
                echo "Usage: h <height>  (0 = native resolution)"
            else
                CFG_HEIGHT=$ARG1
                echo -e "${YELLOW}Updating target height to $CFG_HEIGHT...${NC}"
                send_cmd_pretty "{\"command\":\"configure\",\"config\":{\"fps\":$CFG_FPS,\"targetHeight\":$CFG_HEIGHT,\"sharedMemoryName\":\"/ausm-test\",\"frameCount\":3}}"
            fi
            ;;
        dc)
            echo -e "${CYAN}Display configs:${NC}"
            send_cmd_pretty '{"command":"getDisplayConfigs"}'
            ;;
        m)
            echo -e "${CYAN}Helper process stats:${NC}"
            if ps -p "$HELPER_PID" >/dev/null 2>&1; then
                ps -p "$HELPER_PID" -o pid=,rss=,%cpu=,%mem= | awk '{printf "  PID: %s  RSS: %.1f MB  CPU: %s%%  MEM: %s%%\n", $1, $2/1024, $3, $4}'
            else
                echo -e "${RED}  Helper not running!${NC}"
            fi
            # macOS does not expose POSIX shared memory in the filesystem;
            # the registry is /ausm-test-registry (see README.md).
            ;;
        log)
            echo -e "${CYAN}Last 30 log lines:${NC}"
            tail -30 /tmp/ausm-helper-test.log
            ;;
        raw)
            shift_input="${INPUT#raw }"
            if [ "$shift_input" = "$INPUT" ] || [ -z "$shift_input" ]; then
                echo "Usage: raw {\"command\":\"status\"}"
            else
                send_cmd_pretty "$shift_input"
            fi
            ;;
        q|quit|exit)
            cleanup
            ;;
        "")
            ;;
        *)
            echo "Unknown command: $CMD"
            echo "Commands: d c s x i f h dc m log raw q"
            ;;
    esac
done
