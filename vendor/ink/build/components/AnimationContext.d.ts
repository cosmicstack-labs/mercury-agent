type AnimationContextValue = {
    readonly renderThrottleMs: number;
    readonly subscribe: (callback: (currentTime: number) => void, interval: number) => {
        readonly startTime: number;
        readonly unsubscribe: () => void;
    };
};
declare const AnimationContext: import("react").Context<AnimationContextValue>;
export default AnimationContext;
