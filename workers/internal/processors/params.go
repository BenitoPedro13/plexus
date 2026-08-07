package processors

import "fmt"

// requirePositiveIntParam reads a positive integer param. JSON numbers
// decode as float64 via encoding/json into map[string]interface{}, so this
// accepts float64 and requires it to be a positive whole number.
func requirePositiveIntParam(params map[string]interface{}, key string) (int, error) {
	raw, ok := params[key]
	if !ok {
		return 0, fmt.Errorf("missing required param %q", key)
	}
	f, ok := raw.(float64)
	if !ok || f != float64(int(f)) || f <= 0 {
		return 0, fmt.Errorf("param %q must be a positive integer, got %v", key, raw)
	}
	return int(f), nil
}

// optionalIntParamInRange reads an optional integer param within [min, max],
// returning def if the param is absent.
func optionalIntParamInRange(params map[string]interface{}, key string, def, min, max int) (int, error) {
	if _, ok := params[key]; !ok {
		return def, nil
	}
	return requireIntParamInRange(params, key, min, max)
}

// requireIntParamInRange reads a required integer param within [min, max].
func requireIntParamInRange(params map[string]interface{}, key string, min, max int) (int, error) {
	raw, ok := params[key]
	if !ok {
		return 0, fmt.Errorf("missing required param %q", key)
	}
	f, ok := raw.(float64)
	if !ok || f != float64(int(f)) || int(f) < min || int(f) > max {
		return 0, fmt.Errorf("param %q must be an integer between %d and %d, got %v", key, min, max, raw)
	}
	return int(f), nil
}

// requireFloatParamInRange reads a required float64 param within [min, max].
// JSON numbers decode as float64 via encoding/json into
// map[string]interface{}, so no int/float distinction is needed here.
func requireFloatParamInRange(params map[string]interface{}, key string, min, max float64) (float64, error) {
	raw, ok := params[key]
	if !ok {
		return 0, fmt.Errorf("missing required param %q", key)
	}
	f, ok := raw.(float64)
	if !ok || f < min || f > max {
		return 0, fmt.Errorf("param %q must be a number between %g and %g, got %v", key, min, max, raw)
	}
	return f, nil
}

// optionalFloatParamInRange reads an optional float64 param within [min,
// max], returning def if the param is absent.
func optionalFloatParamInRange(params map[string]interface{}, key string, def, min, max float64) (float64, error) {
	if _, ok := params[key]; !ok {
		return def, nil
	}
	return requireFloatParamInRange(params, key, min, max)
}

// requireStringParam reads a required, non-empty string param.
func requireStringParam(params map[string]interface{}, key string) (string, error) {
	raw, ok := params[key]
	if !ok {
		return "", fmt.Errorf("missing required param %q", key)
	}
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("param %q must be a non-empty string, got %v", key, raw)
	}
	return s, nil
}
