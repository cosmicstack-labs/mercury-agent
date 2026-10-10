import { types } from 'node:util';
import React, { PureComponent } from 'react';
import ErrorOverview from './ErrorOverview.js';
// Error boundary must be a class component since getDerivedStateFromError
// and componentDidCatch are not available as hooks
export default class ErrorBoundary extends PureComponent {
    static displayName = 'InternalErrorBoundary';
    static getDerivedStateFromError(error) {
        return {
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- Error.isError is not available in Node.js 22.
            error: types.isNativeError(error) ? error : new Error(String(error)),
        };
    }
    state = {
        error: undefined,
    };
    componentDidCatch() {
        this.props.onError(this.state.error);
    }
    render() {
        return this.state.error ? (React.createElement(ErrorOverview, { error: this.state.error })) : (this.props.children);
    }
}
