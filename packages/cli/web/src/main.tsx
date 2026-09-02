import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// The components' own appearance first, then this console's page over the top - which is the order
// that lets `app.css` arrange what the toolkit draws without duplicating how it draws it. The
// palette is defined here, in `:root`, and the package's rules read it through fallbacks: change a
// token and the components follow.
import '@source-repo/react/styles.css'
import './app.css'

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
)
