import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Auto-cleanup is only registered when Vitest globals are enabled; they are not,
// so unmount explicitly. Without this, every render accumulates in one document
// and queries start matching several instances.
afterEach(cleanup)
