import { log } from "@/utils/log";
import type { ClientConnection } from "@/app/events/eventRouter";
import { Socket } from "socket.io";
import { onAuthorizedSocketEvent } from "./socketScope";

export function pingHandler(socket: Socket, connection: ClientConnection) {
    onAuthorizedSocketEvent(socket, connection, 'ping', async (callback: (response: any) => void) => {
        try {
            callback({});
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Socket ping failed');
        }
    });
}
