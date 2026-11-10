import { AUSMEvent, EventDataOf, createAUSMEvent } from '../AUSM';

export interface SpaceChangeEvent extends AUSMEvent {
    readonly kind: 'spaceChange';
}

export type SpaceChangeEventData = EventDataOf<SpaceChangeEvent>;

export function createSpaceChangeEvent(data: SpaceChangeEventData = {}): SpaceChangeEvent {
    return {
        ...createAUSMEvent('spaceChange', data),
    };
}
