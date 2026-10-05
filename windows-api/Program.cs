using AcmProvisioning;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.Extensions.Hosting.WindowsServices;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

const string ServiceFlag = "--windows-service";
var asService = args.Any(a => string.Equals(a, ServiceFlag, StringComparison.OrdinalIgnoreCase))
    || WindowsServiceHelpers.IsWindowsService();
var hostArgs = args.Where(a => !string.Equals(a, ServiceFlag, StringComparison.OrdinalIgnoreCase)).ToArray();

BootLog($"pid={Environment.ProcessId} asService={asService} parentDetect={WindowsServiceHelpers.IsWindowsService()} cwd={Environment.CurrentDirectory} base={AppContext.BaseDirectory} args={string.Join(' ', args)}");

var options = new WebApplicationOptions
{
    Args = hostArgs,
    ContentRootPath = asService ? AppContext.BaseDirectory : default
};

var builder = WebApplication.CreateBuilder(options);
if (asService)
{
    // AddWindowsService() is a no-op when parent-process detection fails (RID
    // apphost, some SCM hosts). Register the lifetime ourselves in that case.
    builder.Services.AddWindowsService(o => o.ServiceName = "AcmProvisioning");
    if (!WindowsServiceHelpers.IsWindowsService())
    {
        builder.Services.AddSingleton<IHostLifetime, WindowsServiceLifetime>();
        builder.Services.Configure<WindowsServiceLifetimeOptions>(o => o.ServiceName = "AcmProvisioning");
    }
}
builder.Services.AddSingleton<AdProvisioningService>();
builder.Services.AddRateLimiter(options =>
{
    options.AddPolicy("password-change", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Request.RouteValues["sam"]?.ToString()?.ToUpperInvariant() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 5,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0
        }));
    options.OnRejected = async (context, cancellationToken) =>
    {
        context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        context.HttpContext.Response.Headers.RetryAfter = "60";
        await context.HttpContext.Response.WriteAsJsonAsync(
            new { error = "Too many password change attempts. Wait a minute and try again." }, cancellationToken);
    };
});
var app = builder.Build();

// Production Kestrel otherwise answers unhandled exceptions with 500 and no body.
app.UseExceptionHandler(errorApp =>
{
    errorApp.Run(async context =>
    {
        var err = context.Features.Get<IExceptionHandlerFeature>()?.Error;
        if (err is not null)
        {
            context.RequestServices.GetRequiredService<ILoggerFactory>()
                .CreateLogger("AcmProvisioning")
                .LogError(err, "Unhandled exception");
        }
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        await context.Response.WriteAsJsonAsync(new
        {
            error = err is null ? "internal error" : AdErrors.Format(err)
        });
    });
});

// Bearer token on everything except /healthz
app.UseMiddleware<TokenAuthMiddleware>();
app.UseRateLimiter();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.MapPost("/users", async Task<IResult> (CreateUserRequest req, AdProvisioningService ad) =>
{
    var accountName = req.AccountName;
    if (string.IsNullOrWhiteSpace(accountName) || string.IsNullOrWhiteSpace(req.FirstName)
        || string.IsNullOrWhiteSpace(req.LastName) || string.IsNullOrWhiteSpace(req.DisplayName)
        || string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrWhiteSpace(req.EventId))
    {
        return Results.BadRequest(new { error = "username (or netid), firstName, lastName, displayName, email, and eventId are required." });
    }

    try
    {
        var result = await ad.CreateUserAsync(req);
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        return AdFailure(ex);
    }
});

app.MapPatch("/users/{sam}", async Task<IResult> (string sam, UpdateUserRequest req, AdProvisioningService ad) =>
{
    if (string.IsNullOrWhiteSpace(sam))
    {
        return Results.BadRequest(new { error = "sAMAccountName is required." });
    }

    try
    {
        var result = await ad.UpdateUserAsync(sam, req);
        return Results.Ok(result);
    }
    catch (ProvisioningException ex) when (ex.Message.Contains("was not found", StringComparison.Ordinal))
    {
        return Results.NotFound(new { samAccountName = sam, existed = false });
    }
    catch (Exception ex)
    {
        return AdFailure(ex);
    }
});

app.MapGet("/users/{sam}", async Task<IResult> (string sam, AdProvisioningService ad) =>
{
    try
    {
        var exists = await ad.UserExistsAsync(sam);
        return exists
            ? Results.Ok(new { samAccountName = sam, existed = true })
            : Results.NotFound(new { samAccountName = sam, existed = false });
    }
    catch (Exception ex)
    {
        return AdFailure(ex);
    }
});

app.MapPost("/users/{sam}/password", async Task<IResult> (string sam, ChangePasswordRequest req, AdProvisioningService ad, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    if (string.IsNullOrWhiteSpace(sam) || string.IsNullOrEmpty(req.CurrentPassword) || string.IsNullOrEmpty(req.NewPassword))
        return Results.BadRequest(new { error = "Current and new passwords are required." });
    if (req.CurrentPassword == req.NewPassword)
        return Results.BadRequest(new { error = "Choose a new password that differs from your current password." });
    try
    {
        var changed = await ad.ChangePasswordAsync(sam, req);
        return changed
            ? Results.Ok(new { ok = true })
            : Results.NotFound(new { error = "No Active Directory account was found for this username." });
    }
    catch (PasswordChangeException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
    catch
    {
        // No exception/request logging on a path that handles plaintext passwords.
        return Results.Json(new { error = "Active Directory is unavailable. Contact ACM support." }, statusCode: 502);
    }
}).RequireRateLimiting("password-change");

try
{
    app.Run();
}
catch (Exception ex)
{
    BootLog(ex.ToString());
    try
    {
        File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "startup-error.log"), $"{DateTime.UtcNow:o}{Environment.NewLine}{ex}");
    }
    catch
    {
        // best-effort; SCM has no console
    }
    throw;
}

static IResult AdFailure(Exception ex) =>
    Results.Json(
        new { error = AdErrors.Format(ex) },
        statusCode: ex is ProvisioningException
            ? StatusCodes.Status502BadGateway
            : StatusCodes.Status500InternalServerError);

static void BootLog(string message)
{
    try
    {
        File.AppendAllText(
            Path.Combine(AppContext.BaseDirectory, "service-boot.log"),
            $"{DateTime.UtcNow:o} {message}{Environment.NewLine}");
    }
    catch
    {
        // best-effort; SCM has no console
    }
}
