import { Component, type ReactNode } from 'react';

/** Se uma parte da tela falhar, mostra o erro em vez de deixar a janela em branco. */
export class ErrorBoundary extends Component<{ children: ReactNode; area: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.area}]`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h2>Algo deu errado em {this.props.area}</h2>
        <p>O restante do aplicativo continua funcionando. Detalhe técnico: {this.state.error.message}</p>
        <button className="primary" onClick={() => this.setState({ error: null })}>Tentar de novo</button>
      </div>
    );
  }
}
