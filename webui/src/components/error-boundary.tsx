import { Component, type ReactNode } from "react"

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <div className="text-center">
            <p className="text-sm text-destructive font-medium">Something went wrong</p>
            <p className="mt-1 text-xs text-muted-foreground">{this.state.error?.message}</p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
