/* eslint-disable */
// Declare Electron webview tag as a valid JSX intrinsic element.
// The <webview> element is Electron-specific and isn't in React's JSX types.

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        allowtransparency?: string;
        ref?: React.Ref<Electron.WebviewTag>;
      },
      HTMLElement
    >;
  }
}
