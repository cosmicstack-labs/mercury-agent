import { PureComponent, type ReactNode } from 'react';
type Props = {
    readonly children: ReactNode;
    readonly onError: (error: Error) => void;
};
type State = {
    readonly error?: Error;
};
export default class ErrorBoundary extends PureComponent<Props, State> {
    static displayName: string;
    static getDerivedStateFromError(error: unknown): {
        error: Error;
    };
    state: State;
    componentDidCatch(): void;
    render(): ReactNode;
}
export {};
