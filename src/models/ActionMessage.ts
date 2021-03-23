import { ActionType } from "./ActionType";

export class ActionMessage {
    type: ActionType;
    data: Record<string, unknown>;
    id: number;
}