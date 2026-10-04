// Gamer Sidekick — Win32 window enumeration and display geometry.
//
// Compiled from extensions/win/win32.cs by extensions/win/bootstrap.ps1.

using System;
using System.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Windows.Forms;
using System.Drawing;
using System.Drawing.Imaging;

public static class GsWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);

    // --- Window self-capture ------------------------------------------------
    // PrintWindow asks the window to draw itself into our DC, which is the only
    // way to photograph a window that something else is covering. Cropping a
    // full-desktop grab cannot do this: it records whatever is on top, and for
    // Gamer Sidekick that is always the terminal the player is typing in.
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    /// PW_RENDERFULLCONTENT: undocumented but universally shipped since Win8.1,
    /// and the only flag that reaches DWM-composited and DirectX content.
    private const uint PW_RENDERFULLCONTENT = 0x00000002;
    private const uint GA_ROOT = 2;

    // DwmGetWindowAttribute gives the *perceived* frame — the rect Windows
    // actually lays out and the user actually sees. GetWindowRect disagrees
    // whenever a drop shadow or unscaled border is present, and disagrees more
    // under per-monitor DPI. Cropping from the wrong rect is off by ~8px.
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

    public class Win
    {
        public long Hwnd;
        public string Title;
        public uint Pid;
        public int X, Y, Width, Height;
        public bool Minimized, Maximized, Visible;
        public string Exe;
        public string Path;
    }

    private static RECT Frame(IntPtr h)
    {
        RECT r;
        if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0)
            return r;
        GetWindowRect(h, out r);
        return r;
    }

    private static Win Describe(IntPtr h, long hwnd, string title, uint pid, bool minimized)
    {
        RECT r = Frame(h);
        string exe = null, path = null;
        try
        {
            var p = System.Diagnostics.Process.GetProcessById((int)pid);
            exe = p.ProcessName + ".exe";
            path = p.MainModule.FileName;
        }
        catch { /* protected process, or 32/64-bit mismatch: exe stays unknown */ }

        return new Win
        {
            Hwnd = hwnd,
            Title = title,
            Pid = pid,
            X = r.Left, Y = r.Top,
            Width = r.Right - r.Left,
            Height = r.Bottom - r.Top,
            Minimized = minimized,
            Maximized = IsZoomed(h),
            Visible = IsWindowVisible(h),
            Exe = exe,
            Path = path
        };
    }

    public static Win[] Enumerate(bool includeMinimized)
    {
        var list = new List<Win>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;

            bool min = IsIconic(h);
            if (min && !includeMinimized) return true;

            int len = GetWindowTextLengthW(h);
            if (len == 0) return true; // no title: not a real top-level window

            var sb = new StringBuilder(len + 1);
            GetWindowTextW(h, sb, sb.Capacity);

            uint pid;
            GetWindowThreadProcessId(h, out pid);

            list.Add(Describe(h, h.ToInt64(), sb.ToString(), pid, min));
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    // Single-window query for the capture hot path. Far cheaper than enumerating
    // every window when all we want is "is my handle still valid, and where is
    // it now" — which is exactly the revalidation capture.ts does every time.
    public static Win Query(long hwnd)
    {
        IntPtr h = new IntPtr(hwnd);
        if (!IsWindowVisible(h)) return null;

        uint pid;
        GetWindowThreadProcessId(h, out pid);

        int len = GetWindowTextLengthW(h);
        var sb = new StringBuilder(len + 1);
        GetWindowTextW(h, sb, sb.Capacity);

        return Describe(h, hwnd, sb.ToString(), pid, IsIconic(h));
    }

    public static object[] Screens()
    {
        var outp = new List<object>();
        foreach (Screen s in Screen.AllScreens)
            outp.Add(new { name = s.DeviceName, x = s.Bounds.X, y = s.Bounds.Y, w = s.Bounds.Width, h = s.Bounds.Height, primary = s.Primary });
        return outp.ToArray();
    }

    /// Base64 PNG of the window's own content, ignoring anything covering it.
    /// Returns null when the window cannot be rendered, so the caller can fall
    /// back to the desktop grab.
    public static string Capture(long hwnd)
    {
        IntPtr h = new IntPtr(hwnd);
        if (!IsWindow(h) || !IsWindowVisible(h)) return null;

        RECT r = Frame(h);
        int w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (w <= 0 || ht <= 0 || w > 16384 || ht > 16384) return null;

        IntPtr hdcWindow = GetWindowDC(h);
        if (hdcWindow == IntPtr.Zero) return null;
        try
        {
            using (var bmp = new Bitmap(w, ht, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                try { PrintWindow(h, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }

                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    return Convert.ToBase64String(ms.ToArray());
                }
            }
        }
        catch { return null; }
        finally { ReleaseDC(h, hdcWindow); }
    }

    /// Titles of windows sitting on top of ours, sampled on a 2x2 grid.
    /// Empty means nothing is covering the window.
    public static string[] Occluders(long hwnd)
    {
        var seen = new List<string>();
        IntPtr h = new IntPtr(hwnd);
        if (!IsWindow(h)) return seen.ToArray();

        RECT r = Frame(h);
        for (int i = 1; i <= 2; i++)
        {
            for (int j = 1; j <= 2; j++)
            {
                int x = r.Left + (r.Right - r.Left) * i / 3;
                int y = r.Top + (r.Bottom - r.Top) * j / 3;
                IntPtr top = WindowFromPoint(new POINT { X = x, Y = y });
                if (top == IntPtr.Zero || top == h) continue;

                IntPtr root = GetAncestor(top, GA_ROOT);
                if (root == h || root == IntPtr.Zero) continue;

                var sb = new StringBuilder(GetWindowTextLengthW(root) + 1);
                GetWindowTextW(root, sb, sb.Capacity);
                string label = sb.ToString();
                if (!seen.Contains(label)) seen.Add(label);
            }
        }
        return seen.ToArray();
    }
}
