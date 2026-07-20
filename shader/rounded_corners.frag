// Rounded corners fragment shader
// Clips window corners into smooth rounded shapes.
// Based on the approach used in Mutter's background rendering.

uniform vec4 bounds;       // Window bounds: left, top, right, bottom
uniform float clipRadius;  // Corner radius in pixels
uniform vec2 pixelStep;    // 1/width, 1/height for coordinate conversion

// Calculate whether a point is within the rounded window.
// Returns 0.0 if outside, 1.0 if inside, and values between for antialiasing.
float getCornerAlpha(vec2 p, vec4 bounds, float radius) {
    // If point is outside window bounds entirely
    if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w)
        return 0.0;

    // Find corner center
    vec2 center;

    float centerLeft = bounds.x + radius;
    float centerRight = bounds.z - radius;

    if (p.x < centerLeft)
        center.x = centerLeft;
    else if (p.x > centerRight)
        center.x = centerRight;
    else
        return 1.0;

    float centerTop = bounds.y + radius;
    float centerBottom = bounds.w - radius;

    if (p.y < centerTop)
        center.y = centerTop;
    else if (p.y > centerBottom)
        center.y = centerBottom;
    else
        return 1.0;

    // Distance from corner center
    vec2 delta = p - center;
    float distSquared = dot(delta, delta);

    // Antialiased edge
    float outerRadius = radius + 0.5;
    if (distSquared >= (outerRadius * outerRadius))
        return 0.0;

    float innerRadius = radius - 0.5;
    if (distSquared <= (innerRadius * innerRadius))
        return 1.0;

    return outerRadius - sqrt(distSquared);
}

void main() {
    vec2 p = cogl_tex_coord0_in.xy / pixelStep;
    float alpha = getCornerAlpha(p, bounds, clipRadius);
    cogl_color_out *= alpha;
}
