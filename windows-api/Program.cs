using AcmProvisioning;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<AdProvisioningService>();
var app = builder.Build();

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
    catch (ProvisioningException ex)
    {
        return Results.Problem(ex.Message, statusCode: 502);
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
    catch (ProvisioningException ex)
    {
        return Results.Problem(ex.Message, statusCode: 502);
    }
});

app.MapGet("/users/{sam}", async Task<IResult> (string sam, AdProvisioningService ad) =>
{
    var exists = await ad.UserExistsAsync(sam);
    return exists
        ? Results.Ok(new { samAccountName = sam, existed = true })
        : Results.NotFound(new { samAccountName = sam, existed = false });
});

app.Run();
