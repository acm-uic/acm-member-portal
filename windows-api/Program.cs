using AcmProvisioning;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.Extensions.Hosting.WindowsServices;

var options = new WebApplicationOptions
{
    Args = args,
    ContentRootPath = WindowsServiceHelpers.IsWindowsService()
        ? AppContext.BaseDirectory
        : default
};

var builder = WebApplication.CreateBuilder(options);
builder.Host.UseWindowsService(o => o.ServiceName = "AcmProvisioning");
builder.Services.AddSingleton<AdProvisioningService>();
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

app.Run();

static IResult AdFailure(Exception ex) =>
    Results.Json(
        new { error = AdErrors.Format(ex) },
        statusCode: ex is ProvisioningException
            ? StatusCodes.Status502BadGateway
            : StatusCodes.Status500InternalServerError);
