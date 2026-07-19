// Renders a Google Material Symbol by name (e.g. "home", "menu"). Size/color
// come from whatever CSS class wraps it — font-size and currentColor apply
// the same way they would to text. Used for every icon in the app except
// Google's official "G" mark, which stays as inlined brand SVG.
function Icon({ name, className = '' }) {
  return (
    <span className={`material-symbols-outlined ${className}`.trim()} aria-hidden="true">
      {name}
    </span>
  )
}

export default Icon
