/**
 * useWebSocket.js — WebSocket hook for live updates from Thor backend
 */

import { useEffect, useRef, useCallback, useState } from 'react';

const WS_URL = 'ws://' + window.location.hostname + ':3000/ws';

export function useWebSocket(onMessage) {
    const wsRef = useRef(null);
    const [isConnected, setIsConnected] = useState(false);
    const reconnectTimer = useRef(null);
    const onMessageRef = useRef(onMessage);
    onMessageRef.current = onMessage;

    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return;

        try {
            const ws = new WebSocket(WS_URL);

            ws.onopen = () => {
                setIsConnected(true);
                console.log('[WS] Connected to Thor backend');
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    onMessageRef.current?.(msg);
                } catch {
                    // ignore parse errors
                }
            };

            ws.onclose = () => {
                setIsConnected(false);
                console.log('[WS] Disconnected, reconnecting in 3s...');
                reconnectTimer.current = setTimeout(connect, 3000);
            };

            ws.onerror = () => {
                ws.close();
            };

            wsRef.current = ws;
        } catch {
            reconnectTimer.current = setTimeout(connect, 5000);
        }
    }, []);

    useEffect(() => {
        connect();
        return () => {
            clearTimeout(reconnectTimer.current);
            wsRef.current?.close();
        };
    }, [connect]);

    return { isConnected };
}
