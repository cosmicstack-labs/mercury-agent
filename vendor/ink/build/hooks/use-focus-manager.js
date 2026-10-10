import { use } from 'react';
import FocusContext from '../components/FocusContext.js';
/**
A React hook that returns methods to enable or disable focus management for all components or manually switch focus to the next or previous components.
*/
const useFocusManager = () => {
    const focusContext = use(FocusContext);
    return {
        enableFocus: focusContext.enableFocus,
        disableFocus: focusContext.disableFocus,
        focusNext: focusContext.focusNext,
        focusPrevious: focusContext.focusPrevious,
        focus: focusContext.focus,
        activeId: focusContext.activeId,
    };
};
export default useFocusManager;
