import { createContext } from 'react';
// eslint-disable-next-line @typescript-eslint/naming-convention -- React contexts are named like components.
const AnimationContext = createContext({
    renderThrottleMs: 0,
    subscribe() {
        return {
            startTime: 0,
            unsubscribe() { },
        };
    },
});
AnimationContext.displayName = 'InternalAnimationContext';
export default AnimationContext;
