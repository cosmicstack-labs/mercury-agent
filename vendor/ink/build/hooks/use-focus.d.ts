type Input = {
    /**
    Enable or disable this component's focus, while still maintaining its position in the list of focusable components.
    */
    isActive?: boolean;
    /**
    Auto-focus this component if there's no active (focused) component right now.
    */
    autoFocus?: boolean;
    /**
    Assign an ID to this component, so it can be programmatically focused with `focus(id)`. The ID must be unique among focusable components.
    */
    id?: string;
};
type Output = {
    /**
    Determines whether this component is focused.
    */
    isFocused: boolean;
    /**
    Allows focusing a specific element with the provided `id`.
    */
    focus: (id: string) => void;
};
/**
A React hook that returns focus state and focus controls for the current component.
A component that uses the `useFocus` hook becomes "focusable" to Ink, so when the user presses <kbd>Tab</kbd>, Ink will switch focus to this component. If there are multiple components that execute the `useFocus` hook, focus will be given to them in registration order. Reordering keyed components does not change their registration order.
*/
declare const useFocus: ({ isActive, autoFocus, id: customId, }?: Input) => Output;
export default useFocus;
