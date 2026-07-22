// Theme preference — stored in localStorage so it persists across sessions
// Three options: 'system' (follows OS), 'light', 'dark'
const STORAGE_KEY = 'signal-theme'

export function getTheme() {
  return localStorage.getItem(STORAGE_KEY) || 'system'
}

export function setTheme(theme) {
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}

// Applies the theme by setting/removing a data-theme attribute on <html>
// Called on app startup and whenever the user changes their preference
export function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', theme)
  }
}
