using System.Security.Cryptography;
using System.Text;

namespace AcmProvisioning;

/// <summary>
/// Shared-bearer-token gate (k8s Secret on the portal side, environment
/// variable here). /healthz stays open for monitoring. Constant-time
/// comparison; IP allowlisting belongs to the host firewall (README).
/// </summary>
public sealed class TokenAuthMiddleware
{
    private readonly RequestDelegate _next;
    private readonly string _token;

    public TokenAuthMiddleware(RequestDelegate next, IConfiguration config)
    {
        _next = next;
        _token = config["Provisioning:Token"]
            ?? throw new InvalidOperationException("Provisioning:Token is required");
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (context.Request.Path.StartsWithSegments("/healthz"))
        {
            await _next(context);
            return;
        }

        var header = context.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        var presented = header.StartsWith(prefix, StringComparison.Ordinal)
            ? header[prefix.Length..]
            : string.Empty;

        var expected = Encoding.UTF8.GetBytes(_token);
        var actual = Encoding.UTF8.GetBytes(presented);
        if (actual.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(actual, expected))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = "unauthorized" });
            return;
        }

        await _next(context);
    }
}
