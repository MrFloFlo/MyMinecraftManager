const fs = require('fs/promises');
const path = require('path');

async function showPage() {
  try {
    // Resolve absolute paths for partials
    const viewsDir = path.resolve('./views/html');

    // Read all required HTML partials
    const [
      header,
      nav,
      status,
      instances,
      terminal,
      footer
    ] = await Promise.all([
      fs.readFile(path.join(viewsDir, 'header.html'), 'utf-8'),
      fs.readFile(path.join(viewsDir, 'nav.html'), 'utf-8'),
      fs.readFile(path.join(viewsDir, 'status.html'), 'utf-8'),
      fs.readFile(path.join(viewsDir, 'instances.html'), 'utf-8'),
      fs.readFile(path.join(viewsDir, 'terminal.html'), 'utf-8'),
      fs.readFile(path.join(viewsDir, 'footer.html'), 'utf-8'),
    ]);

    // Stitch everything together
    const html = `
      ${header}
      ${nav}
      <div class="container-fluid mt-4">
        ${status}
        ${instances}
        ${terminal}
      </div>
      ${footer}
    `;

    return html;

  } catch (err) {
    console.error("Error assembling page:", err);
    throw err;
  }
}

module.exports = showPage