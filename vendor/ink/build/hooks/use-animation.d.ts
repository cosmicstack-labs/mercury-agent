type Options = {
    /**
    Time between ticks in milliseconds.

    @default 100
    */
    readonly interval?: number;
    /**
    Whether the animation is running. When set to `false`, the animation stops. When toggled back to `true`, all values reset to `0`.

    @default true
    */
    readonly isActive?: boolean;
};
export type AnimationResult = {
    /**
    Discrete counter that increments by 1 each interval. Useful for indexed sequences like spinner frames.
    */
    readonly frame: number;
    /**
    Total elapsed time in milliseconds since the animation started or was last reset. Useful for continuous math-based animations like sine waves: `Math.sin(time / 1000 * Math.PI * 2)`.
    */
    readonly time: number;
    /**
    Time in milliseconds since the previous rendered tick. Accounts for throttled renders. Useful for physics-based or velocity-driven motion: `position += speed * delta`.
    */
    readonly delta: number;
    /**
    Resets `frame`, `time`, and `delta` to `0` and restarts timing from the current moment. Useful for one-shot animations triggered by events.
    */
    readonly reset: () => void;
};
/**
A React hook that drives animations. Returns a frame counter, elapsed time, frame delta, and a reset function. All animations share a single timer internally, so multiple animated components consolidate into one render cycle.

@example
```
import {Text, useAnimation} from 'ink';

const Spinner = () => {
    const {frame} = useAnimation({interval: 80});
    const characters = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    return <Text>{characters[frame % characters.length]}</Text>;
};
```
*/
export default function useAnimation(options?: Options): AnimationResult;
export {};
