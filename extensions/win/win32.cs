// Gamer Sidekick — Win32 window enumeration and display geometry.
//
// Compiled from extensions/win/win32.cs by extensions/win/bootstrap.ps1.

using System;
using System.Text;
using System.IO;
// `Encoder` is ambiguous once System.Text is in scope: System.Text.Encoder is
// the base64 codec, System.Drawing.Imaging.Encoder is the JPEG quality enum.
// This file needs the text encoder (Convert.ToBase64String) and the imaging one.
using Encoder = System.Drawing.Imaging.Encoder;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Windows.Forms;
using System.Drawing;
using System.Drawing.Drawing2D;
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
        Screen[] all = Screen.AllScreens;
        // The index is emitted, not inferred. GrabRegion indexes Screen.AllScreens
        // the same way, so publishing the ordinal here is what guarantees a
        // display picked at bind time is the display grabbed at capture time.
        for (int i = 0; i < all.Length; i++)
        {
            Screen s = all[i];
            outp.Add(new { i, name = s.DeviceName, x = s.Bounds.X, y = s.Bounds.Y, w = s.Bounds.Width, h = s.Bounds.Height, primary = s.Primary });
        }
        return outp.ToArray();
    }

    // --- Rendered frames ----------------------------------------------------
    // Scaling and JPEG encoding live here rather than in JavaScript so the
    // intermediate bitmap never has to cross the process boundary. Encoding a
    // 2560x1440 window to PNG and shipping ~5.9 MB of base64 out to be decoded
    // again costs more than the resize and the encode combined; the only thing
    // that should leave this process is the finished frame, ~150 KB.

    /// One finished frame: the encoded bytes plus everything the caller needs
    /// to decide whether it is usable, so nothing has to be decoded again.
    public class Shot
    {
        public string Jpeg;      // base64, image/jpeg
        public int Width;
        public int Height;
        public int SourceWidth;  // before scaling
        public int SourceHeight;
        public double RedMean;   // 0..255, for the black-frame check
    }

    private static ImageCodecInfo JpegCodec()
    {
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
            if (c.FormatID == ImageFormat.Jpeg.Guid) return c;
        return null;
    }

    /// Mean value of the red channel, sampled at up to ~65k pixels.
    ///
    /// A GDI screen copy under exclusive fullscreen comes back all-zero, and
    /// handing that to a vision model produces confident, wrong answers — so the
    /// caller would rather be told "no frame" than be sent a black rectangle.
    /// Sampling rather than summing every pixel keeps this a fixed cost.
    private static double RedMean(Bitmap bmp)
    {
        try
        {
            Rectangle r = new Rectangle(0, 0, bmp.Width, bmp.Height);
            long total = (long)r.Width * r.Height;
            int step = (int)Math.Max(1, total / 65536);

            BitmapData data = bmp.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                byte[] row = new byte[data.Stride];
                IntPtr scan0 = data.Scan0;
                double sum = 0;
                long n = 0;
                for (int y = 0; y < r.Height; y++)
                {
                    Marshal.Copy(scan0 + y * data.Stride, row, 0, Math.Abs(data.Stride));
                    for (int x = 0; x < r.Width; x += step)
                    {
                        sum += row[x * 4 + 2]; // B,G,R,A
                        n++;
                    }
                }
                return n == 0 ? 0 : sum / n;
            }
            finally { bmp.UnlockBits(data); }
        }
        catch { return 0; }
    }

    /// Scale to a long edge, JPEG-encode, and report the statistics.
    /// maxEdge <= 0 means "do not downscale".
    private static Shot Encode(Bitmap bmp, int maxEdge, int quality)
    {
        ImageCodecInfo codec = JpegCodec();
        if (codec == null) return null;

        int srcW = bmp.Width, srcH = bmp.Height;
        int longEdge = Math.Max(srcW, srcH);
        double scale = (maxEdge > 0 && longEdge > maxEdge) ? (double)maxEdge / longEdge : 1.0;
        int w = Math.Max(1, (int)Math.Round(srcW * scale));
        int h = Math.Max(1, (int)Math.Round(srcH * scale));

        try
        {
            using (var scaled = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.SmoothingMode = SmoothingMode.HighQuality;
                    g.DrawImage(bmp, new Rectangle(0, 0, w, h));
                }

                double mean = RedMean(scaled);

                using (var ms = new MemoryStream())
                {
                    using (EncoderParameters ep = new EncoderParameters(1))
                    {
                        ep.Param[0] = new EncoderParameter(Encoder.Quality, (long)Math.Max(1, Math.Min(100, quality)));
                        scaled.Save(ms, codec, ep);
                    }
                    return new Shot
                    {
                        Jpeg = Convert.ToBase64String(ms.ToArray()),
                        Width = w,
                        Height = h,
                        SourceWidth = srcW,
                        SourceHeight = srcH,
                        RedMean = mean
                    };
                }
            }
        }
        catch { return null; }
        finally { bmp.Dispose(); }
    }

    /// The bound window, rendered by itself, scaled and encoded.
    /// Null means the window could not be drawn — the caller falls back to a
    /// region grab, which records occluders but at least produces a frame.
    public static Shot CaptureJpeg(long hwnd, int maxEdge, int quality)
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

                return Encode(bmp, maxEdge, quality);
            }
        }
        catch { return null; }
        finally { ReleaseDC(h, hdcWindow); }
    }

    /// Fallback path: copy a region of a display and encode that.
    ///
    /// This is what a window that will not draw itself gets. It records whatever
    /// is on top, so the caller has to say so in the caption — a vision model
    /// reads a hole as content and fills it in confidently.
    ///
    /// Coordinates are display-relative. The caller got the display's origin
    /// from Screens(), in this same DPI-virtualised context, so they agree.
    public static Shot GrabRegion(int screenIndex, int left, int top, int width, int height, int maxEdge, int quality)
    {
        Screen[] screens = Screen.AllScreens;
        if (screenIndex < 0 || screenIndex >= screens.Length) return null;
        Rectangle bounds = screens[screenIndex].Bounds;
        if (bounds.Width <= 0 || bounds.Height <= 0) return null;

        // Clamp to the display. A window dragged half off the edge yields the
        // visible part rather than an error.
        int x1 = Math.Max(0, Math.Min(left, bounds.Width - 1));
        int y1 = Math.Max(0, Math.Min(top, bounds.Height - 1));
        int x2 = Math.Min(bounds.Width, left + width);
        int y2 = Math.Min(bounds.Height, top + height);
        if (x2 <= x1 || y2 <= y1) return null;

        try
        {
            using (var display = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(display))
                    g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, display.Size);

                using (var region = display.Clone(new Rectangle(x1, y1, x2 - x1, y2 - y1), PixelFormat.Format32bppArgb))
                    return Encode(region, maxEdge, quality);
            }
        }
        catch { return null; }
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
