/**
 * Selection Monitor Demo
 * 
 * Run with: npm run demo
 * 
 * This demo shows text selection events in real-time.
 * Select text in any application to see the events.
 * 
 * Requirements:
 * - macOS with Accessibility permissions granted
 * - The native module must be built first (npm install)
 */

const path = require('path');

// Load the native module directly for the demo
const gypBuild = require('node-gyp-build');
const nativeModule = gypBuild(path.resolve(__dirname, '..'));

console.log('='.repeat(60));
console.log('AUSM Selection Monitor Demo');
console.log('='.repeat(60));
console.log('');

// Create instance
const monitor = new nativeModule.SelectionMonitor();

// Check accessibility permissions
const isTrusted = monitor.isProcessTrusted();
console.log(`Accessibility Permission: ${isTrusted ? '✅ Granted' : '❌ Not Granted'}`);

if (!isTrusted) {
    console.log('');
    console.log('⚠️  Accessibility permission required!');
    console.log('   Requesting permission (check System Settings > Privacy & Security > Accessibility)...');
    console.log('');
    monitor.requestProcessTrust();
    
    // Give user time to grant permission
    console.log('Waiting 3 seconds for permission...');
    setTimeout(() => {
        const nowTrusted = monitor.isProcessTrusted();
        if (!nowTrusted) {
            console.log('');
            console.log('❌ Still no permission. Please grant accessibility permission and run again.');
            console.log('   Go to: System Settings > Privacy & Security > Accessibility');
            console.log('   Add and enable this terminal/app.');
            process.exit(1);
        }
        startMonitoring();
    }, 3000);
} else {
    startMonitoring();
}

function startMonitoring() {
    console.log('');
    console.log('Starting selection monitor...');
    console.log('');
    console.log('📝 Select text in any application to see events');
    console.log('🖱️  Mouse events will be shown (except move events)');
    console.log('⌨️  Keyboard events will be shown');
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('');
    console.log('-'.repeat(60));

    // Event counters
    let selectionCount = 0;
    let mouseCount = 0;
    let keyCount = 0;

    // Start monitoring with callback
    monitor.start((event) => {
        if (!event || !event.type) return;

        const timestamp = new Date().toLocaleTimeString();

        switch (event.type) {
            case 'text-selection': {
                selectionCount++;
                console.log('');
                console.log(`[${timestamp}] 📝 TEXT SELECTION #${selectionCount}`);
                console.log('-'.repeat(40));
                
                // Truncate long text for display
                const displayText = event.text.length > 100 
                    ? event.text.substring(0, 100) + '...' 
                    : event.text;
                console.log(`Text: "${displayText}"`);
                console.log(`App:  ${event.localizedName || event.programName}`);
                console.log(`Bundle: ${event.programName}`);
                console.log(`Method: ${getMethodName(event.method)} | Detect: ${getDetectName(event.detectType)}`);
                
                if (event.posLevel >= 3) {
                    console.log(`Bounds: (${event.startTopX.toFixed(0)}, ${event.startTopY.toFixed(0)}) - (${event.endBottomX.toFixed(0)}, ${event.endBottomY.toFixed(0)})`);
                }
                
                if (event.isFullscreen) {
                    console.log('Fullscreen: Yes');
                }
                console.log('');
                break;
            }
            
            case 'mouse-event': {
                mouseCount++;
                // Only show click events, not move events (too noisy)
                if (event.action === 'mouse-down' || event.action === 'mouse-up') {
                    console.log(`[${timestamp}] 🖱️  ${event.action.toUpperCase()} at (${event.x.toFixed(0)}, ${event.y.toFixed(0)}) button=${event.button}`);
                } else if (event.action === 'mouse-wheel') {
                    const direction = event.flag > 0 ? 'up' : 'down';
                    console.log(`[${timestamp}] 🖱️  SCROLL ${direction} at (${event.x.toFixed(0)}, ${event.y.toFixed(0)})`);
                }
                break;
            }
            
            case 'keyboard-event': {
                keyCount++;
                const keyDisplay = event.uniKey.length === 1 && event.uniKey !== ' ' 
                    ? `'${event.uniKey}'` 
                    : event.uniKey;
                const sysIndicator = event.sys ? ' [SYS]' : '';
                console.log(`[${timestamp}] ⌨️  ${event.action.toUpperCase()} ${keyDisplay}${sysIndicator}`);
                break;
            }
        }
    });

    console.log('✅ Monitor started!');
    console.log('');

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('');
        console.log('-'.repeat(60));
        console.log('Stopping monitor...');
        monitor.stop();
        console.log('');
        console.log('📊 Session Statistics:');
        console.log(`   Text Selections: ${selectionCount}`);
        console.log(`   Mouse Events: ${mouseCount}`);
        console.log(`   Keyboard Events: ${keyCount}`);
        console.log('');
        console.log('Goodbye! 👋');
        process.exit(0);
    });
}

// Helper functions
function getMethodName(method) {
    switch (method) {
        case 0: return 'None';
        case 11: return 'AXAPI';
        case 99: return 'Clipboard';
        default: return `Unknown(${method})`;
    }
}

function getDetectName(detectType) {
    switch (detectType) {
        case 0: return 'None';
        case 1: return 'Drag';
        case 2: return 'DoubleClick';
        case 3: return 'ShiftClick';
        default: return `Unknown(${detectType})`;
    }
}
